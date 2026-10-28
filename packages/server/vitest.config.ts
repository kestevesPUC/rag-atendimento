import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { BCRYPT_COST: '4' }, // só nos testes: hash barato para a suíte de API ficar rápida
    testTimeout: 15_000,
  },
});
