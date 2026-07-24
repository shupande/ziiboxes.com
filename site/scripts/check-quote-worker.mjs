import assert from "node:assert/strict";
import worker from "../src/worker.js";

const form = new FormData();
form.set("box_style", "Mailer box");
form.set("quantity", "1000");
form.set("size", "20 x 15 x 8 cm");
form.set("destination", "United States");
form.set("contact", "buyer@example.com");
form.set("material_finish", "FSC kraft, matte print");
form.set("notes", "Need recycled paper option");

let sent;
const response = await worker.fetch(
  new Request("https://www.ziiboxes.com/api/quote", {
    method: "POST",
    body: form,
  }),
  {
    EMAIL: {
      async send(message) {
        sent = message;
      },
    },
  },
);

assert.equal(response.status, 200);
assert.equal(sent.to, "sales@ziiboxes.com");
assert.equal(sent.from.email, "quote@ziiboxes.com");
assert.equal(sent.replyTo, "buyer@example.com");
assert.match(sent.text, /Quantity: 1000/);
