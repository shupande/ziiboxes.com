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
  if (env.SMTP_SEND) {
    return env.SMTP_SEND(message);
  }

  if (!env.SMTP_PASSWORD) {
    throw smtpError("SMTP_NOT_CONFIGURED");
  }

  const host = env.SMTP_HOST || "smtp.ym.163.com";
  const port = Number(env.SMTP_PORT || 994);
  const username = env.SMTP_USERNAME || message.from;
  const { connect } = await import("cloudflare:sockets");
  const secureTransport = port === 587 ? "starttls" : "on";
  let socket = connect({ hostname: host, port }, { secureTransport });

  await socket.opened;
  let session = createSmtpSession(socket);

  try {
    await session.expect(220);
    await session.command("EHLO ziiboxes.com", 250);

    if (port === 587) {
      await session.command("STARTTLS", 220);
      socket = socket.startTls();
      await socket.opened;
      session = createSmtpSession(socket);
      await session.command("EHLO ziiboxes.com", 250);
    }

    await session.command("AUTH LOGIN", 334);
    await session.command(base64(username), 334);
    await session.command(base64(env.SMTP_PASSWORD), 235);
    await session.command(`MAIL FROM:<${message.from}>`, 250);
    await session.command(`RCPT TO:<${message.to}>`, 250);
    await session.command("DATA", 354);
    await session.write(formatEmail(message) + "\r\n.\r\n");
    await session.expect(250);
    await session.command("QUIT", 221);
  } finally {
    await socket.close().catch(() => {});
  }
}

function createSmtpSession(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async write(value) {
      await writer.write(encoder.encode(value));
    },
    async command(value, okCode) {
      await this.write(value + "\r\n");
      return this.expect(okCode);
    },
    async expect(okCode) {
      const response = await readResponse();
      if (response.code !== okCode) {
        throw smtpError(`SMTP_${response.code}`, response.text);
      }
      return response;
    },
  };

  async function readLine() {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        return line;
      }

      const { value, done } = await reader.read();
      if (done) {
        throw smtpError("SMTP_CONNECTION_CLOSED");
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  async function readResponse() {
    let text = "";

    for (;;) {
      const line = await readLine();
      text += (text ? "\n" : "") + line;

      const match = /^(\d{3})([ -])/.exec(line);
      if (match && match[2] === " ") {
        return { code: Number(match[1]), text };
      }
    }
  }
}

function formatEmail(message) {
  const headers = [
    `From: "${message.fromName}" <${message.from}>`,
    `To: ${message.to}`,
    message.replyTo ? `Reply-To: ${message.replyTo}` : "",
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@ziiboxes.com>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);

  return `${headers.join("\r\n")}\r\n\r\n${wrap(base64(message.text))}`;
}

function wrap(value) {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }

  return btoa(binary);
}

function smtpError(code, message = code) {
  const error = new Error(message);
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
