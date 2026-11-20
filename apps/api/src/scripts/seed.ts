import argon2 from 'argon2';
import { PrismaClient, Role } from '@prisma/client';

// Cria o primeiro administrador. Roda a cada subida do Docker (serviço "migrate"):
// se já existe um administrador, não faz nada — pode remover ADMIN_PASSWORD do .env depois.
const prisma = new PrismaClient();

// --redefinir-senha: troca a senha de ADMIN_EMAIL pela de ADMIN_PASSWORD, desliga o 2FA
// dele e encerra suas sessões. Para quando o único administrador perdeu o acesso.
async function resetPassword() {
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Defina ADMIN_EMAIL e a nova senha em ADMIN_PASSWORD no .env');
  if (password.length < 10) throw new Error('ADMIN_PASSWORD precisa ter ao menos 10 caracteres');
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`Usuário ${email} não encontrado`);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await argon2.hash(password), active: true, totpEnabled: false, totpSecretEnc: null, totpRecoveryCodes: [] },
  });
  await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await prisma.auditLog.create({ data: { userId: user.id, action: 'auth.password_reset_cli' } });
  console.log(`Senha de ${email} redefinida; verificação em duas etapas desligada.`);
}

async function main() {
  if (process.argv.includes('--redefinir-senha')) return resetPassword();
  const admins = await prisma.user.count({ where: { role: Role.ADMIN } });
  if (admins > 0) {
    console.log('Já existe administrador; nada a fazer.');
    return;
  }
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Nenhum administrador cadastrado: defina ADMIN_EMAIL e ADMIN_PASSWORD no .env');
  if (password.length < 10) throw new Error('ADMIN_PASSWORD precisa ter ao menos 10 caracteres');

  await prisma.user.create({ data: { email, name: 'Administrador', role: Role.ADMIN, passwordHash: await argon2.hash(password) } });
  console.log(`Administrador ${email} criado.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
