const {
  sendAxiomAlert,
  AXIOM_WEBHOOK_SECRET,
} = require("../../lib/guardian");

module.exports =
  async function handler(
    req,
    res
  ) {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    const providedSecret =
      req.headers[
        "x-guardian-secret"
      ];

    if (
      !AXIOM_WEBHOOK_SECRET ||
      providedSecret !==
        AXIOM_WEBHOOK_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    try {
      const payload =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body;

      if (!payload) {
        return res.status(400).json({
          ok: false,
          error: "Missing payload",
        });
      }

      await sendAxiomAlert(
        payload
      );

      return res.status(200).json({
        ok: true,
      });

    } catch (error) {
      console.error(
        "Axiom webhook error:",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ??
          "Invalid payload",
      });
    }
  };