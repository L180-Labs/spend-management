import { ConfigService } from '@nestjs/config';

// Explicit opt-in, and never active in a production process.
export function isLocalDevelopment(config: ConfigService): boolean {
  return config.get('NODE_ENV') === 'development' && config.get('LOCAL_DEV_MODE') === 'true';
}
