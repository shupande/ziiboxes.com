import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citedSourceUrls, readGuideDocuments, validateGenerated } from "./validate-guides.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topicsPath = path.join(siteRoot, "data", "blog-topics.json");
const guidesDir = path.join(siteRoot, "src", "content", "guides");
const maxSourceBytes = 1_500_000;

function chatUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export function providerOptions(baseUrl) {
  return new URL(baseUrl).hostname.toLowerCase().endsWith(".aliyuncs.com")
    ? { enable_thinking: false }
    : {};
}

function checkSourceUrl(rawUrl) {
  const url = new URL(rawUrl);
  const blockedHost = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/i;
  if (url.protocol !== "https:" || blockedHost.test(url.hostname)) {
    throw new Error(`Unsafe research URL: ${rawUrl}`);
  }
  return url;
}

function htmlToText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSourceOnce(source) {
  checkSourceUrl(source.url);
  const response = await fetch(source.url, {
    headers: { "user-agent": "ZiiBoxes content research/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  checkSourceUrl(response.url);
  if (!response.ok) throw new Error(`Could not read ${source.url}: HTTP ${response.status}`);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxSourceBytes) {
      await reader.cancel();
      throw new Error(`Research page is too large: ${source.url}`);
    }
    chunks.push(value);
  }
  const html = new TextDecoder().decode(Buffer.concat(chunks));
  const text = htmlToText(html).slice(0, 24_000);
  if (text.length < 300) throw new Error(`Research page has too little readable text: ${source.url}`);
  return { title: source.title, url: source.url, text };
}

export async function fetchSource(source) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchSourceOnce(source);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function ensureInternalLinksExist(urls) {
  for (const url of urls) {
    if (!url.startsWith("/") || url.startsWith("//")) throw new Error(`Invalid internal link: ${url}`);
    const target = path.join(siteRoot, "dist", url, url.endsWith("/") ? "index.html" : "");
    try {
      await access(target);
    } catch {
      throw new Error(`Approved internal link does not exist in the built site: ${url}`);
    }
  }
}

function parseModelJson(content) {
  const text = Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : part.text || "").join("")
    : content;
  return JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/gi, "").trim());
}

async function requestModelJson(messages) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;

  const response = await fetch(chatUrl(baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      ...providerOptions(baseUrl),
      response_format: { type: "json_object" },
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(`AI request failed with HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const reasoningLength = choice?.message?.reasoning_content?.length || 0;
    throw new Error(
      `AI response did not contain an article (finish reason: ${choice?.finish_reason || "unknown"}, reasoning characters: ${reasoningLength}).`,
    );
  }
  return parseModelJson(content);
}

async function generateArticle(topic, research, existingGuides) {
  const systemPrompt = await readFile(path.join(siteRoot, "prompts", "guide-system-prompt.md"), "utf8");
  const companyFacts = JSON.parse(await readFile(path.join(siteRoot, "data", "company-facts.json"), "utf8"));
  const existingArticles = existingGuides.map((guide) => ({
    slug: guide.slug,
    title: guide.data.title,
    description: guide.data.description,
    primaryKeyword: guide.data.primaryKeyword || null,
  }));
  const request = {
    approvedTopic: topic,
    companyFacts,
    existingArticles,
    research,
    instructions: [
      "Keep the approved slug, category, and primary keyword exactly unchanged.",
      "Use every approved internal link naturally in the article.",
      "Cite at least two approved research sources in the article.",
      "Return valid JSON only.",
    ],
  };
  return requestModelJson([
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(request) },
  ]);
}

async function repairArticle(article, topic, issues) {
  const systemPrompt = await readFile(path.join(siteRoot, "prompts", "guide-system-prompt.md"), "utf8");
  return requestModelJson([
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: JSON.stringify({
        task: "Correct the full draft so every validation issue is fixed. Return the complete JSON article, not a patch.",
        validationIssues: issues,
        rules: [
          "Do not change the approved slug, category, primary keyword, verified claims, citations, or internal links.",
          "Keep the article between 1,800 and 2,500 words.",
          "The description must contain 150–160 characters.",
          "Use the exact heading `## FAQ`, followed by exactly five questions formatted as `### Question?` with an answer after each.",
        ],
        approvedTopic: topic,
        draftArticle: article,
      }),
    },
  ]);
}

function markdownDocument(article, topic, order, date) {
  return `---
title: ${JSON.stringify(article.title)}
seoTitle: ${JSON.stringify(article.seoTitle)}
description: ${JSON.stringify(article.description)}
category: ${JSON.stringify(article.category)}
order: ${order}
pubDate: ${JSON.stringify(date)}
updatedDate: ${JSON.stringify(date)}
primaryKeyword: ${JSON.stringify(article.primaryKeyword)}
image: ${JSON.stringify(topic.image)}
imageAlt: ${JSON.stringify(topic.imageAlt)}
sources: ${JSON.stringify(article.sourceUrls)}
---

${article.articleMarkdown.trim()}
`;
}

async function main() {
  if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL || !process.env.AI_MODEL) {
    throw new Error("AI_API_KEY, AI_BASE_URL, and AI_MODEL must all be configured.");
  }
  const topics = JSON.parse(await readFile(topicsPath, "utf8"));
  const topic = topics.find((item) => item.status === "queued");
  if (!topic) {
    console.log("No approved topic is queued.");
    return;
  }
  if (!Array.isArray(topic.sources) || topic.sources.length < 2 || topic.sources.length > 5) {
    throw new Error("A queued topic must have 2–5 approved research sources.");
  }

  const existingGuides = await readGuideDocuments();
  if (existingGuides.some((guide) => guide.slug === topic.slug)) {
    throw new Error(`Guide already exists: ${topic.slug}`);
  }
  await ensureInternalLinksExist(topic.internalLinks);
  await access(path.join(siteRoot, "public", topic.image));

  console.log(`Reading ${topic.sources.length} approved sources for: ${topic.topic}`);
  const sourceResults = await Promise.allSettled(topic.sources.map(fetchSource));
  const research = sourceResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
  for (const result of sourceResults.filter((item) => item.status === "rejected")) {
    console.warn(result.reason.message);
  }
  if (research.length < 2) throw new Error("Fewer than two approved research sources could be read.");
  console.log(`Generating with model: ${process.env.AI_MODEL}`);
  let article = await generateArticle(topic, research, existingGuides);
  for (let repairs = 0; ; repairs += 1) {
    article.sourceUrls = citedSourceUrls(article.articleMarkdown || "", topic.sources);
    const issues = validateGenerated(article, topic, existingGuides);
    if (!issues.length) break;
    if (repairs === 2) throw new Error(`Generated article failed checks:\n- ${issues.join("\n- ")}`);
    console.log(`Draft needs correction (${repairs + 1}/2): ${issues.join("; ")}`);
    article = await repairArticle(article, topic, issues);
  }

  const order = Math.max(...existingGuides.map((guide) => Number(guide.data.order) || 0)) + 1;
  const date = new Date().toISOString().slice(0, 10);
  const articlePath = path.join(guidesDir, `${topic.slug}.md`);
  const temporaryPath = `${articlePath}.tmp`;
  await writeFile(temporaryPath, markdownDocument(article, topic, order, date), "utf8");
  await rename(temporaryPath, articlePath);

  Object.assign(topic, {
    status: "generated",
    generatedSlug: topic.slug,
    generatedAt: new Date().toISOString(),
  });
  await writeFile(topicsPath, `${JSON.stringify(topics, null, 2)}\n`, "utf8");
  console.log(`Created ${path.relative(siteRoot, articlePath)}. It is ready for review.`);
}

function selfTest() {
  if (providerOptions("https://dashscope.aliyuncs.com/compatible-mode/v1").enable_thinking !== false) {
    throw new Error("Alibaba requests must disable thinking");
  }
  if (Object.keys(providerOptions("https://api.openai.com/v1")).length !== 0) {
    throw new Error("Other providers must not receive Alibaba-only options");
  }
  console.log("AI provider options self-test passed.");
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else await main();
}
