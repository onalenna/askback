const OpenAI = require('openai');
const { AzureOpenAI } = require('openai');

/**
 * Single AI client factory for the whole app.
 *
 * Every module talks to ONE object shaped like the OpenAI SDK: it exposes
 * `client.chat.completions.create(...)` and `client.embeddings.create(...)`.
 * Whisper transcription uses `client.audio.transcriptions.create(...)`.
 *
 * Four providers are supported, chosen by which env vars are set (first match
 * wins): OpenRouter, Azure OpenAI, AWS Bedrock, then plain OpenAI. Azure and
 * OpenRouter use the OpenAI SDK directly. Bedrock has a different API, so it is
 * wrapped in a thin adapter (below) that presents the same two methods, which
 * means NO caller needs to change when you switch providers.
 *
 * Model names: pass a short OpenAI-style id (e.g. 'gpt-4o'); each provider
 * maps it to what that provider expects via env overrides.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

let _client = null;
let _whisper = null;

// -------- provider detection --------

/**
 * An explicit AI_PROVIDER in the environment wins over auto-detection. This
 * matters when a machine has ambient provider vars set system-wide (e.g. a
 * developer's AZURE_OPENAI_* exports): the project's .env choice must still win.
 * @returns {''|'openai'|'openrouter'|'azure'|'bedrock'}
 */
function forcedProvider() {
  const p = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  return ['openai', 'openrouter', 'azure', 'bedrock'].includes(p) ? p : '';
}

function usingOpenRouter() {
  const forced = forcedProvider();
  if (forced) return forced === 'openrouter';
  return Boolean(String(process.env.OPENROUTER_API_KEY || '').trim());
}

function usingAzure() {
  const forced = forcedProvider();
  if (forced) return forced === 'azure';
  return Boolean(
    String(process.env.AZURE_OPENAI_API_KEY || '').trim() &&
      String(process.env.AZURE_OPENAI_ENDPOINT || '').trim()
  );
}

function usingBedrock() {
  // Bedrock is opt-in via AI_PROVIDER=bedrock so ambient AWS creds on a
  // developer machine do not silently hijack the provider.
  return forcedProvider() === 'bedrock';
}

/** Human name of the active provider, for logging. */
function providerName() {
  if (usingOpenRouter()) return 'OpenRouter';
  if (usingAzure()) return 'Azure OpenAI';
  if (usingBedrock()) return 'AWS Bedrock';
  return 'OpenAI';
}

// -------- model name resolution --------

/** Map a short OpenAI model id to the active provider's expected id. */
function resolveModel(shortName) {
  const name = String(shortName || '').trim();
  if (!name) return name;
  if (usingOpenRouter()) return name.includes('/') ? name : `openai/${name}`;
  // Azure uses deployment names, set explicitly via the *_DEPLOYMENT vars.
  // Bedrock uses full model ids, set via the BEDROCK_* vars.
  return name;
}

const CHAT_MODEL = () => {
  if (usingAzure()) {
    return (
      process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ||
      process.env.CHAT_MODEL ||
      'gpt-4o'
    );
  }
  if (usingBedrock()) {
    return process.env.BEDROCK_CHAT_MODEL || 'anthropic.claude-sonnet-4-5-20250929-v1:0';
  }
  return resolveModel(process.env.OPENROUTER_CHAT_MODEL || process.env.CHAT_MODEL || 'gpt-4o');
};

const CHAT_MODEL_MINI = () => {
  if (usingAzure()) {
    return (
      process.env.AZURE_OPENAI_MINI_DEPLOYMENT ||
      process.env.CHAT_MODEL_MINI ||
      'gpt-4o-mini'
    );
  }
  if (usingBedrock()) {
    return process.env.BEDROCK_MINI_MODEL || process.env.BEDROCK_CHAT_MODEL ||
      'anthropic.claude-3-haiku-20240307-v1:0';
  }
  return resolveModel(process.env.OPENROUTER_MINI_MODEL || process.env.CHAT_MODEL_MINI || 'gpt-4o-mini');
};

const EMBEDDING_MODEL = () => {
  if (usingAzure()) {
    return (
      process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ||
      process.env.EMBEDDING_MODEL ||
      'text-embedding-3-small'
    );
  }
  if (usingBedrock()) {
    return process.env.BEDROCK_EMBEDDING_MODEL || 'amazon.titan-embed-text-v2:0';
  }
  return resolveModel(process.env.EMBEDDING_MODEL || 'text-embedding-3-small');
};

const EMBEDDING_DIMENSIONS = 512;

// -------- client construction --------

function getClient() {
  if (_client) return _client;

  if (usingOpenRouter()) {
    _client = new OpenAI({
      apiKey: String(process.env.OPENROUTER_API_KEY).trim(),
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://127.0.0.1:3000',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'askBack',
      },
    });
  } else if (usingAzure()) {
    // AzureOpenAI presents the same chat.completions / embeddings interface.
    _client = new AzureOpenAI({
      apiKey: String(process.env.AZURE_OPENAI_API_KEY).trim(),
      endpoint: String(process.env.AZURE_OPENAI_ENDPOINT).trim(),
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    });
  } else if (usingBedrock()) {
    _client = createBedrockClient();
  } else {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  console.log(`[ai] using ${providerName()} for chat + embeddings`);
  return _client;
}

/**
 * Whisper (voice-note transcription) needs OpenAI's audio API. Azure also
 * offers it via the same SDK. Bedrock/OpenRouter have no drop-in Whisper, so we
 * fall back to a real OpenAI key when one is present; otherwise the caller
 * handles the missing-transcription case (voice notes get a text reply).
 */
function getWhisperClient() {
  const openAiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (openAiKey) {
    if (!_whisper) _whisper = new OpenAI({ apiKey: openAiKey });
    return _whisper;
  }
  if (usingAzure()) return getClient(); // Azure Whisper deployment, if configured
  return getClient();
}

// -------- Bedrock adapter --------

/**
 * Build an object that looks like the OpenAI SDK but talks to AWS Bedrock.
 * Only the two surfaces the app uses are implemented: chat.completions.create
 * and embeddings.create. Requires @aws-sdk/client-bedrock-runtime.
 */
function createBedrockClient() {
  let BedrockRuntimeClient;
  let InvokeModelCommand;
  try {
    ({ BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime'));
  } catch {
    throw new Error(
      'AI_PROVIDER=bedrock but @aws-sdk/client-bedrock-runtime is not installed. Run: npm install @aws-sdk/client-bedrock-runtime'
    );
  }

  const region = process.env.AWS_REGION || process.env.BEDROCK_REGION || 'us-east-1';
  // Credentials come from the standard AWS chain (env vars, shared config,
  // instance role). Explicit keys win when provided.
  const explicitKey = String(process.env.AWS_ACCESS_KEY_ID || '').trim();
  const credentials = explicitKey
    ? {
        accessKeyId: explicitKey,
        secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
        ...(process.env.AWS_SESSION_TOKEN
          ? { sessionToken: String(process.env.AWS_SESSION_TOKEN).trim() }
          : {}),
      }
    : undefined;

  const runtime = new BedrockRuntimeClient({ region, ...(credentials ? { credentials } : {}) });

  async function invoke(modelId, body) {
    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    });
    const res = await runtime.send(command);
    return JSON.parse(Buffer.from(res.body).toString('utf8'));
  }

  const isAnthropic = (id) => /anthropic|claude/i.test(String(id || ''));

  return {
    chat: {
      completions: {
        /**
         * Mirror of OpenAI chat.completions.create for the fields the app uses:
         * model, messages, temperature, response_format. Returns the same
         * shape: { choices: [{ message: { content } }] }.
         */
        async create({ model, messages = [], temperature = 0.4, response_format } = {}) {
          const modelId = model || CHAT_MODEL();

          if (isAnthropic(modelId)) {
            // Anthropic on Bedrock: system prompt is separate from turns.
            const system = messages
              .filter((m) => m.role === 'system')
              .map((m) => m.content)
              .join('\n\n');
            const turns = messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));
            const wantsJson = response_format?.type === 'json_object';
            const body = {
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: Number(process.env.BEDROCK_MAX_TOKENS || 1024),
              temperature,
              ...(system ? { system: wantsJson ? `${system}\nReturn valid JSON only.` : system } : {}),
              messages: turns.length ? turns : [{ role: 'user', content: '' }],
            };
            const out = await invoke(modelId, body);
            const content = Array.isArray(out.content)
              ? out.content.map((c) => c.text || '').join('')
              : String(out.completion || '');
            return { choices: [{ message: { content } }] };
          }

          // Amazon Titan text models.
          const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
          const body = {
            inputText: prompt,
            textGenerationConfig: {
              temperature,
              maxTokenCount: Number(process.env.BEDROCK_MAX_TOKENS || 1024),
            },
          };
          const out = await invoke(modelId, body);
          const content = (out.results && out.results[0]?.outputText) || '';
          return { choices: [{ message: { content } }] };
        },
      },
    },
    embeddings: {
      /**
       * Mirror of OpenAI embeddings.create. Bedrock embeds ONE input per call,
       * so a batch (array input) is fanned out. Returns the OpenAI shape:
       * { data: [{ index, embedding }] }.
       */
      async create({ model, input } = {}) {
        const modelId = model || EMBEDDING_MODEL();
        const inputs = Array.isArray(input) ? input : [input];
        const data = [];
        for (let i = 0; i < inputs.length; i += 1) {
          const body = /titan/i.test(modelId)
            ? { inputText: String(inputs[i] ?? ''), dimensions: EMBEDDING_DIMENSIONS, normalize: true }
            : { inputText: String(inputs[i] ?? '') };
          const out = await invoke(modelId, body);
          const embedding = out.embedding || (out.embeddings && out.embeddings[0]) || [];
          data.push({ index: i, embedding });
        }
        return { data };
      },
    },
  };
}

// Back-compat proxy for modules that import `{ openai }` directly.
// Chat completions are routed through the concurrency limiter + retry so a
// burst of simultaneous questions cannot overwhelm the provider or fail on a
// transient 429. Other properties pass through unchanged.
const { runAi } = require('./limiter');

const openai = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getClient();
      if (prop === 'chat') {
        const chat = client.chat;
        return {
          completions: {
            create: (args) => runAi(() => chat.completions.create(args)),
          },
        };
      }
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  }
);

async function getEmbedding(text) {
  const response = await runAi(() =>
    getClient().embeddings.create({
      model: EMBEDDING_MODEL(),
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    })
  );
  return response.data[0].embedding;
}

async function getEmbeddingsBatch(texts) {
  const response = await runAi(() =>
    getClient().embeddings.create({
      model: EMBEDDING_MODEL(),
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    })
  );
  const map = {};
  response.data.forEach((item) => {
    map[item.index] = item.embedding;
  });
  return texts.map((_, i) => map[i]);
}

module.exports = {
  openai,
  getClient,
  getWhisperClient,
  getEmbedding,
  getEmbeddingsBatch,
  usingOpenRouter,
  usingAzure,
  usingBedrock,
  providerName,
  resolveModel,
  CHAT_MODEL,
  CHAT_MODEL_MINI,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
