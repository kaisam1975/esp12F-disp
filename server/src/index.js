const express = require('express');

function createApp({ getClaudeCache, getGrokCache }) {
  const app = express();
  app.get('/display', (req, res) => {
    res.json({
      claude: getClaudeCache(),
      grok: getGrokCache(),
      updatedAt: new Date().toISOString(),
    });
  });
  return app;
}

function startBackgroundRefreshers({
  claudeRefreshSeconds,
  grokRefreshSeconds,
  refreshClaudeUsage,
  refreshGrokUsage,
}) {
  refreshClaudeUsage();
  refreshGrokUsage();
  const claudeTimer = setInterval(refreshClaudeUsage, claudeRefreshSeconds * 1000);
  const grokTimer = setInterval(refreshGrokUsage, grokRefreshSeconds * 1000);
  return { claudeTimer, grokTimer };
}

module.exports = { createApp, startBackgroundRefreshers };

if (require.main === module) {
  const claude = require('./claude');
  const grok = require('./grok');
  const PORT = process.env.PORT || 8787;
  const app = createApp({ getClaudeCache: claude.getClaudeCache, getGrokCache: grok.getGrokCache });
  startBackgroundRefreshers({
    claudeRefreshSeconds: Number(process.env.CLAUDE_REFRESH_SECONDS) || 60,
    grokRefreshSeconds: Number(process.env.GROK_REFRESH_SECONDS) || 300,
    refreshClaudeUsage: claude.refreshClaudeUsage,
    refreshGrokUsage: grok.refreshGrokUsage,
  });
  app.listen(PORT, () => console.log(`usage-api listening on ${PORT}`));
}
