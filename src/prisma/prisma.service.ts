import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  // Legacy alias — existing services use this.prisma.db.model
  readonly db: this = this;

  constructor() {
    // Adapter must be created here (not at module scope) so DATABASE_URL is available
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    super({ adapter } as any);
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
