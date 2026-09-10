export function registerAccountRoutes(app, { accountUsageService, route }) {
  app.get('/api/deepseek/balance', route(async (_req, res) => {
    res.json(await accountUsageService.getBalance());
  }));

  app.get('/api/usage/session', (_req, res) => {
    res.json(accountUsageService.getSessionUsage());
  });
}
