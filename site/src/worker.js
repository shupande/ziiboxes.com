const RECIPIENT = "sales@ziiboxes.com";
const SENDER = RECIPIENT;
const FIELD_LABELS = {
  box_style: "Box style",
  quantity: "Quantity",
  size: "Size",
  destination: "Destination country",
  contact: "Email or WhatsApp",
  material_finish: "Material or finish",
  notes: "Project notes or artwork link",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/quote") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const length = Number(request.headers.get("content-length") || 0);
    if (length > 64000) {
      return json({ ok: false, error: "Request is too large" }, 413);
    }

    const form = await request.formData();
    if (field(form, "company_website")) {
      return json({ ok: true });
    }

    const contact = field(form, "contact", 300);
    if (!contact) {
      return json({ ok: false, error: "Contact is required" }, 400);
    }

    const lines = Object.entries(FIELD_LABELS).map(([name, label]) => {
      const value = field(form, name, name === "notes" ? 4000 : 1000) || "-";
      return `${label}: ${value}`;
    });

    const message = {
      to: RECIPIENT,
      from: { email: SENDER, name: "ZiiBoxes Quote Form" },
      subject: "New quote request from ziiboxes.com",
      text: lines.join("\n"),
    };

    if (looksLikeEmail(contact)) {
      message.replyTo = contact;
    }

    try {
      await env.EMAIL.send(message);
    } catch (error) {
      console.error("Quote email failed", error);
      return json({ ok: false, error: "Email not sent", code: error.code || "EMAIL_SEND_FAILED" }, 502);
    }

    return json({ ok: true });
  },
};

function field(form, name, max = 1000) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
