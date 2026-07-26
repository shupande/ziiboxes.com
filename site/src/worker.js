const RECIPIENT = "sales@ziiboxes.com";
const SENDER = "quotes@faithtechate.com";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
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

    if (url.pathname === "/about-us" || url.pathname === "/about-us/") {
      return Response.redirect(new URL("/about/", url), 301);
    }

    if (url.pathname !== "/api/quote") {
      if (url.pathname === "/api/turnstile-config") {
        return json({
          ok: true,
          siteKey: (env.TURNSTILE_SITE_KEY || "").trim(),
        });
      }

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

    const turnstile = await verifyTurnstile(form, request, env);
    if (!turnstile.ok) {
      return json({ ok: false, error: turnstile.error }, turnstile.status);
    }

    const lines = Object.entries(FIELD_LABELS).map(([name, label]) => {
      const value = field(form, name, name === "notes" ? 4000 : 1000) || "-";
      return `${label}: ${value}`;
    });

    const message = {
      to: env.QUOTE_RECIPIENT || RECIPIENT,
      from: env.RESEND_FROM || SENDER,
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
        },
        502,
      );
    }

    return json({ ok: true });
  },
};

async function verifyTurnstile(form, request, env) {
  const secret = (env.TURNSTILE_SECRET || env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "Anti-spam check is not configured.",
    };
  }

  const token = field(form, "cf-turnstile-response", 4096);
  if (!token) {
    return {
      ok: false,
      status: 400,
      error: "Please complete the anti-spam check.",
    };
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });

  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) body.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        error: "Anti-spam check failed. Please try again.",
      };
    }

    const result = await response.json();
    if (result && result.success === true) return { ok: true };

    if (Array.isArray(result?.["error-codes"]) && result["error-codes"].includes("invalid-input-secret")) {
      return {
        ok: false,
        status: 503,
        error: "Anti-spam check is not configured.",
      };
    }
  } catch (error) {
    console.error("Turnstile verification failed", error);
    return {
      ok: false,
      status: 502,
      error: "Anti-spam check failed. Please try again.",
    };
  } finally {
    clearTimeout(timeout);
  }

  return {
    ok: false,
    status: 403,
    error: "Please complete the anti-spam check.",
  };
}

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
