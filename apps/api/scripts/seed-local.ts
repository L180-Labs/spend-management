import { ConfigModule } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  await ConfigModule.forRoot();
  const database = new URL(process.env.DATABASE_URL || '');
  if (process.env.NODE_ENV !== 'development' || process.env.LOCAL_DEV_MODE !== 'true' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || database.pathname !== '/spend_management') {
    throw new Error('Local seed requires development mode and the local spend_management database.');
  }
  const password = process.env.LOCAL_DEV_PASSWORD;
  if (!password || password.length < 12) throw new Error('Set LOCAL_DEV_PASSWORD to at least 12 characters.');
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.upsert({
      where: { slug: 'local-development' }, update: {},
      create: { slug: 'local-development', name: 'Local Development', currency: 'USD', planTier: 'PRO' },
    });
    const department = await prisma.department.upsert({
      where: { orgId_code: { orgId: org.id, code: 'ENG' } }, update: {},
      create: { orgId: org.id, code: 'ENG', name: 'Engineering' },
    });
    const email = 'developer@example.test';
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.upsert({
      where: { orgId_email: { orgId: org.id, email } },
      update: { passwordHash, isActive: true, deletedAt: null },
      create: { orgId: org.id, email, name: 'Local Developer', initials: 'LD', passwordHash },
    });
    await prisma.departmentMembership.upsert({
      where: { userId_departmentId: { userId: user.id, departmentId: department.id } },
      update: { role: 'ADMIN', isPrimary: true },
      create: { userId: user.id, departmentId: department.id, role: 'ADMIN', isPrimary: true },
    });
    console.log(`Local account ready: ${email} (password in apps/api/.env)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
