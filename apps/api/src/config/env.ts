import { z } from 'zod';

// Validação das variáveis de ambiente: o processo não sobe com configuração inválida.
const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  LOG_LEVEL: z.string().default('info'),
  WEB_URL: z.string().default('http://localhost:3000'),
  API_PORT: z.coerce.number().int().default(4000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de ao menos 32 caracteres'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY precisa ter 64 caracteres hex (openssl rand -hex 32)'),
  COOKIE_SECURE: bool.default(false),

  // Teto do produto: no máximo 10 números, mesmo que o .env peça mais.
  MAX_NUMBERS: z.coerce.number().int().min(1).max(10).default(10),
  MAX_UPLOAD_MB: z.coerce.number().int().default(50),
  MAX_MEDIA_MB: z.coerce.number().int().default(100),

  // Espelhamento
  SYNC_FULL_HISTORY: bool.default(true),
  HISTORY_MEDIA_DAYS: z.coerce.number().int().min(0).default(7),
  // Força a versão do WhatsApp Web (ex.: 2.3000.1029000000). Só para emergência; vazio = automático.
  WA_VERSION: z.string().optional(),
  // Detalhe dos logs da biblioteca do WhatsApp (warn, info, debug). Use debug só para diagnóstico.
  // Como o sistema se identifica ao WhatsApp. "chrome" (padrão) = WhatsApp Web no navegador.
  // "desktop" = app de computador, pede o histórico completo, mas o WhatsApp pode recusar o pareamento.
  WA_BROWSER: z.enum(['chrome', 'desktop']).default('chrome'),
  // Captação pela base de CNPJ da Receita Federal.
  CNPJ_LOCAL_DIR: z.string().default('./dados-cnpj'), // ZIPs baixados à mão (opcional)
  CNPJ_TMP_DIR: z.string().optional(), // onde os ZIPs baixados ficam enquanto são lidos
  CNPJ_LISTING_URL: z.string().default('https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/'),
  CNPJ_NEXTCLOUD_URL: z.string().default('https://arquivos.receitafederal.gov.br'),
  CNPJ_NEXTCLOUD_TOKEN: z.string().default('YggdBLfdninEJX9'),
  // Versão da Graph API da Meta usada na pesquisa de perfis do Instagram.
  // IA do SDR (API da Anthropic). Sem chave, a IA fica desligada.
  ANTHROPIC_API_KEY: z.string().optional(),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v24.0'),
  BAILEYS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('warn'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./data/media'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
});

const parsed = schema.safeParse(
  // variáveis vazias no .env contam como ausentes
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
);
if (!parsed.success) {
  console.error('Configuração inválida:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
