import argon2 from 'argon2';
import { PrismaClient, Role } from '@prisma/client';

// Cria o primeiro administrador. Seguro para rodar mais de uma vez.
const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env antes de rodar o seed');
  if (password.length < 10) throw new Error('ADMIN_PASSWORD precisa ter ao menos 10 caracteres');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Administrador ${email} já existe; nada a fazer.`);
    return;
  }
  await prisma.user.create({
    data: { email, name: 'Administrador', role: Role.ADMIN, passwordHash: await argon2.hash(password) },
  });
  console.log(`Administrador ${email} criado.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
