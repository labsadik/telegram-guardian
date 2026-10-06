module.exports =
  async function handler(
    req,
    res
  ) {
    return res.status(200).json({
      ok: true,
      service:
        "telegram-guardian",
      telegram: true,
      axiom: true,
      time:
        new Date().toISOString(),
    });
  };