import { freezeSuite } from './evolution.mjs';
// Shared before any task writes or model requests, CLI and native host.
export async function prepareAutoEvolution({ cwd, contractFile, skill, suiteFile, maxRequests }) {
  if (!contractFile || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill || '') || !suiteFile || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw new Error('auto-evolve 需要 contract、skill、suite 和 maxRequests 1–100；一次候选，不重放任务');
  const frozen = await freezeSuite(cwd, suiteFile);
  if (1 + 2 * frozen.suite.cases.length * frozen.suite.budget.maxSteps > maxRequests) throw new Error('auto-evolve 请求预算不足');
  return frozen;
}
