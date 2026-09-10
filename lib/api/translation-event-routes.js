export function registerTranslationEventRoutes(app, { translationService, jobRepository, route }) {
  app.get('/api/translation-jobs/:id/events', route(async (req, res) => {
    const job = jobRepository.getById(req.params.id);
    if (!job) throw Object.assign(new Error('翻译任务不存在。'), { status: 404 });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, payload) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    send('job', translationService.publicJob(job));
    const unsubscribe = translationService.subscribe(req.params.id, ({ event, payload }) => send(event, payload));
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref?.();
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  }));
}
