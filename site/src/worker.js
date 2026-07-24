const RECIPIENT = "sales@ziiboxes.com";
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
      to: env.QUOTE_RECIPIENT || RECIPIENT,
      from: env.SMTP_FROM || env.SMTP_USERNAME || RECIPIENT,
      fromName: "ZiiBoxes Quote Form",
      subject: "New quote request from ziiboxes.com",
      text: lines.join("\n"),
    };

    if (looksLikeEmail(contact)) {
      message.replyTo = contact;
    }

    try {
      await sendQuoteEmail(env, message);
    } catch (error) {
      console.error("Quote email failed", error);
      return json(
        {
          ok: false,
          error: "Email not sent",
          code: error.code || "EMAIL_SEND_FAILED",
          detail: String(error.message || "").slice(0, 300),
        },
        502,
      );
    }

    return json({ ok: true });
  },
};

async function sendQuoteEmail(env, message) {
  if (env.RESEND_SEND) {
    return env.RESEND_SEND(message);
  }

  const apiKey = (env.resend || "").trim();

  if (!apiKey) {
    throw emailError("RESEND_NOT_CONFIGURED");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: sender(message),
      to: [message.to],
      subject: message.subject,
      text: message.text,
      reply_to: message.replyTo,
    }),
  });

  if (!response.ok) {
    throw emailError(`RESEND_${response.status}`, await response.text());
  }
}

function sender(message) {
  return /</.test(message.from) ? message.from : `${message.fromName} <${message.from}>`;
}

function emailError(code, message = code) {
  const error = new Error(String(message).slice(0, 300));
  error.code = code;
  return error;
}

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
