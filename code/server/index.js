import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const usersFile = path.join(dataDir, 'users.json');
const port = Number(process.env.PORT || 8787);
const tokenSecret = process.env.AUTH_SECRET || 'divideconta-dev-secret-change-me';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 8,
  },
});
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'divideconta-api' });
});

app.post('/api/invoices/extract', upload.array('files', 8), async (request, response) => {
  try {
    const files = request.files || [];
    const bank = String(request.body.bank || '').trim();
    const cardName = String(request.body.cardName || '').trim();
    const last4 = String(request.body.last4 || '').trim();
    const referenceMonth = String(request.body.referenceMonth || 'Maio/2025').trim();

    if (!files.length) return response.status(400).json({ error: 'Envie um PDF ou pelo menos uma imagem da fatura.' });
    const invalid = files.find((file) => !isInvoiceFile(file));
    if (invalid) return response.status(400).json({ error: `Formato nao suportado: ${invalid.originalname}. Use PDF, JPG, JPEG ou PNG.` });

    if (!openai) {
      return response.status(503).json({
        error: 'OPENAI_API_KEY nao configurada. Use a extracao local do app ou configure a chave para extracao no servidor.',
      });
    }

    const extracted = await extractInvoiceWithOpenAI({ files, bank, cardName, last4, referenceMonth });

    response.json(extracted);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Nao foi possivel analisar a fatura agora.' });
  }
});

app.post('/api/auth/register', async (request, response) => {
  try {
    const name = String(request.body.name || '').trim();
    const email = normalizeEmail(request.body.email);
    const password = String(request.body.password || '');

    if (name.length < 2) return response.status(400).json({ error: 'Informe seu nome.' });
    if (!isEmail(email)) return response.status(400).json({ error: 'Informe um email valido.' });
    if (password.length < 8) return response.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });

    const store = await readStore();
    if (store.users.some((user) => user.email === email)) {
      return response.status(409).json({ error: 'Ja existe um perfil com esse email.' });
    }

    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };

    store.users.push(user);
    await writeStore(store);

    const publicUser = toPublicUser(user);
    response.status(201).json({ user: publicUser, token: signToken(publicUser) });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Erro ao criar perfil.' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  try {
    const email = normalizeEmail(request.body.email);
    const password = String(request.body.password || '');
    const store = await readStore();
    const user = store.users.find((item) => item.email === email);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return response.status(401).json({ error: 'Email ou senha invalidos.' });
    }

    const publicUser = toPublicUser(user);
    response.json({ user: publicUser, token: signToken(publicUser) });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Erro ao entrar no perfil.' });
  }
});

app.get('/api/auth/me', async (request, response) => {
  try {
    const token = getBearerToken(request);
    const payload = verifyToken(token);
    if (!payload) return response.status(401).json({ error: 'Sessao invalida.' });

    const store = await readStore();
    const user = store.users.find((item) => item.id === payload.sub);
    if (!user) return response.status(404).json({ error: 'Perfil nao encontrado.' });

    response.json({ user: toPublicUser(user) });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

function isInvoiceFile(file) {
  return ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype);
}

async function extractInvoiceWithOpenAI({ files, bank, cardName, last4, referenceMonth }) {
  const uploadedFiles = await Promise.all(files.map(async (file) => {
    const uploadFile = await toFile(file.buffer, sanitizeFilename(file.originalname), { type: file.mimetype });
    return openai.files.create({ file: uploadFile, purpose: file.mimetype === 'application/pdf' ? 'user_data' : 'vision' });
  }));

  const fileInputs = files.map((file, index) => ({
    type: file.mimetype === 'application/pdf' ? 'input_file' : 'input_image',
    file_id: uploadedFiles[index].id,
  }));

  const result = await openai.responses.create({
    model: process.env.OPENAI_INVOICE_MODEL || 'gpt-4o-mini',
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            'Voce e um extrator de faturas de cartao brasileiras para o app DivideConta.',
            'Leia todos os arquivos enviados, sejam PDFs ou imagens/fotos da fatura.',
            'Extraia somente lancamentos de compra. Ignore cabecalho, pagamentos, encargos, resumo, limite, codigos de barra, publicidade e totais.',
            'Normalize datas como DD/MM/AAAA quando houver ano; se faltar ano, use 2025.',
            'Normalize valores como numero decimal positivo em reais.',
            'Use parcela "-" para compras a vista e "atual/total" para parceladas.',
            'Marque suggestedMine como true apenas quando houver indicio forte de recorrencia ou item pessoal comum; caso contrario false.',
            `Banco: ${bank || 'nao informado'}. Cartao: ${cardName || 'nao informado'} final ${last4 || '----'}. Mes de referencia: ${referenceMonth}.`,
          ].join('\n'),
        },
        ...fileInputs,
      ],
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'divideconta_invoice_extraction',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['referenceMonth', 'sourceType', 'items'],
          properties: {
            referenceMonth: { type: 'string' },
            sourceType: { type: 'string', enum: ['pdf', 'images', 'mixed'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['date', 'description', 'installment', 'amount', 'suggestedMine'],
                properties: {
                  date: { type: 'string' },
                  description: { type: 'string' },
                  installment: { type: 'string' },
                  amount: { type: 'number' },
                  suggestedMine: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  });

  const parsed = JSON.parse(result.output_text);
  return normalizeExtraction({
    ...parsed,
    engine: 'openai',
    fileNames: files.map((file) => file.originalname),
  });
}

function normalizeExtraction(extraction) {
  const items = (extraction.items || [])
    .map((item, index) => ({
      id: `upload-${Date.now()}-${index}`,
      date: cleanText(item.date) || '',
      description: cleanText(item.description).toUpperCase(),
      installment: cleanText(item.installment) || '-',
      amount: Number(item.amount || 0),
      mine: Boolean(item.suggestedMine),
      manual: false,
    }))
    .filter((item) => item.description && item.amount > 0)
    .sort((a, b) => invoiceDateKey(a.date) - invoiceDateKey(b.date));

  return {
    engine: extraction.engine || 'openai',
    referenceMonth: extraction.referenceMonth || 'Maio/2025',
    sourceType: extraction.sourceType || 'mixed',
    fileNames: extraction.fileNames || [],
    items,
    totals: {
      all: items.reduce((sum, item) => sum + item.amount, 0),
      mine: items.filter((item) => item.mine).reduce((sum, item) => sum + item.amount, 0),
      count: items.length,
      mineCount: items.filter((item) => item.mine).length,
    },
  };
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeFilename(name) {
  return String(name || 'fatura.pdf').replace(/[^\w.\-() ]+/g, '_');
}

function invoiceDateKey(date) {
  const [day, month, year] = String(date || '').split('/').map((part) => Number(part));
  return new Date(year || 2025, (month || 1) - 1, day || 1).getTime();
}

app.listen(port, () => {
  console.log(`DivideConta API listening on http://localhost:${port}`);
});

async function readStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(usersFile, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const store = { users: [] };
    await writeStore(store);
    return store;
  }
}

async function writeStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(usersFile, `${JSON.stringify(store, null, 2)}\n`);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    initials: getInitials(user.name),
    createdAt: user.createdAt,
  };
}

function getInitials(name) {
  const initials = String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return initials || 'JS';
}

function signToken(user) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  }));
  const signature = crypto
    .createHmac('sha256', tokenSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;

  const expected = crypto
    .createHmac('sha256', tokenSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (parsed.exp && parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}
