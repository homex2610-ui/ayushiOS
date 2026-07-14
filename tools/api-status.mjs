import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keysPath = path.join(__dirname, '..', 'keys.json');
const keys = JSON.parse(readFileSync(keysPath, 'utf8'));

function maskKey(key) {
  if (!key || key.length < 8) return '(empty)';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

async function checkProvider(name, key, testFn) {
  const status = key ? 'key set' : 'no key';
  const masked = maskKey(key);
  let reachable = 'untested';
  if (key && testFn) {
    try {
      reachable = await testFn(key);
    } catch {
      reachable = 'error';
    }
  }
  return { name, key: masked, status, reachable };
}

async function testOpenRouter(key) {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  return r.ok ? 'ok' : `HTTP ${r.status}`;
}

async function testGemini(key) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
  const data = await r.json();
  return data.models?.length > 0 ? 'ok' : `HTTP ${r.status}`;
}

async function testDeepSeek(key) {
  const r = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  return r.ok ? 'ok' : `HTTP ${r.status}`;
}

async function testGroq(key) {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  return r.ok ? 'ok' : `HTTP ${r.status}`;
}

async function testOpenAI(key) {
  const r = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (r.status === 401) return 'invalid key';
  return r.ok ? 'ok' : `HTTP ${r.status}`;
}

async function testMistral(key) {
  const r = await fetch('https://api.mistral.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  return r.ok ? 'ok' : `HTTP ${r.status}`;
}

async function testCerebras(key) {
  const r = await fetch('https://api.cerebras.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  return r.ok ? 'ok' : `HTTP ${r.status}`;
}

async function testOllama() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags');
    if (!r.ok) return `HTTP ${r.status}`;
    const data = await r.json();
    const models = data.models?.map(m => m.name).join(', ') || 'none';
    return `ok (models: ${models})`;
  } catch {
    return 'unreachable';
  }
}

const checks = [
  checkProvider('GROQCLOUD_API_KEY', keys.GROQCLOUD_API_KEY, testGroq),
  checkProvider('GEMINI_API_KEY', keys.GEMINI_API_KEY, testGemini),
  checkProvider('DEEPSEEK_API_KEY', keys.DEEPSEEK_API_KEY, testDeepSeek),
  checkProvider('OPENROUTER_API_KEY', keys.OPENROUTER_API_KEY, testOpenRouter),
  checkProvider('ANTHROPIC_API_KEY', keys.ANTHROPIC_API_KEY),
  checkProvider('OPENAI_API_KEY', keys.OPENAI_API_KEY, testOpenAI),
  checkProvider('MISTRAL_API_KEY', keys.MISTRAL_API_KEY, testMistral),
  checkProvider('XAI_API_KEY', keys.XAI_API_KEY),
  checkProvider('QWEN_API_KEY', keys.QWEN_API_KEY),
  checkProvider('HYPERBOLIC_API_KEY', keys.HYPERBOLIC_API_KEY),
  checkProvider('NOVITA_API_KEY', keys.NOVITA_API_KEY),
  checkProvider('CEREBRAS_API_KEY', keys.CEREBRAS_API_KEY, testCerebras),
  checkProvider('MERCURY_API_KEY', keys.MERCURY_API_KEY),
  checkProvider('HUGGINGFACE_API_KEY', keys.HUGGINGFACE_API_KEY),
];

const results = await Promise.all(checks);
results.push(await checkProvider('Ollama (local)', 'n/a', testOllama));

console.log('\n=== API Key Status ===\n');
console.log('Provider'.padEnd(25), 'Key'.padEnd(20), 'Status'.padEnd(12), 'Reachable');
console.log('-'.repeat(80));
for (const r of results) {
  console.log(r.name.padEnd(25), r.key.padEnd(20), r.status.padEnd(12), r.reachable);
}
console.log('\nKeys configured: ' + results.filter(r => r.status !== 'no key' && r.name !== 'Ollama (local)').length + '/13');
console.log('Working APIs: ' + results.filter(r => r.reachable === 'ok').length);
console.log();
