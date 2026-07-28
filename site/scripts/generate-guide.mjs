import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citedSourceUrls, readGuideDocuments, titleSimilarity, validateGenerated } from "./validate-guides.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topicsPath = path.join(siteRoot, "data", "blog-topics.json");
const sourceCatalogPath = path.join(siteRoot, "data", "research-sources.json");
const guidesDir = path.join(siteRoot, "src", "content", "guides");
const maxSourceBytes = 1_500_000;
const targetAudience = "US brand owners, ecommerce businesses, and packaging buyers";

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

async function availableGuideImages() {
  const files = await readdir(path.join(siteRoot, "public", "images"), { recursive: true });
  return files
    .filter((file) => /\.(?:jpe?g|png|webp)$/i.test(file))
    .map((file) => `/images/${file.split(path.sep).join("/")}`)
    .filter((file) => !/\/logo\.(?:jpe?g|png|webp)$/i.test(file))
    .sort();
}

async function builtSectionLinks(section) {
  try {
    const entries = await readdir(path.join(siteRoot, "dist", section), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !/^\d+$/.test(entry.name))
      .map((entry) => ({
        title: entry.name.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
        url: `/${section}/${entry.name}/`,
      }));
  } catch {
    return [];
  }
}

async function availableInternalLinks(existingGuides) {
  const links = [
    ...existingGuides.map((guide) => ({ title: guide.data.title, url: `/guides/${guide.slug}/` })),
    ...await builtSectionLinks("products"),
    ...await builtSectionLinks("industries"),
    { title: "Packaging quote checklist", url: "/packaging-quote-checklist/" },
    { title: "Custom packaging sample process", url: "/custom-packaging-sample-process/" },
    { title: "Request a custom packaging quote", url: "/request-a-quote/" },
    { title: "Contact ZiiBoxes", url: "/contact/" },
  ];
  return [...new Map(links.map((link) => [link.url, link])).values()];
}

function topicCandidateIssues(candidate, context) {
  const issues = [];
  const sourceIds = Array.isArray(candidate.sourceIds) ? candidate.sourceIds : [];
  const internalLinks = Array.isArray(candidate.internalLinks) ? candidate.internalLinks : [];
  const secondaryKeywords = Array.isArray(candidate.secondaryKeywords) ? candidate.secondaryKeywords : [];
  const knownSourceIds = new Set(context.sourceCatalog.map((source) => source.id));
  const knownLinks = new Set(context.internalLinks.map((link) => link.url));
  const knownImages = new Set(context.images);

  if (!candidate.topic || candidate.topic.length < 20 || candidate.topic.length > 80) {
    issues.push("The topic title must contain 20 to 80 characters.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.slug || "") || candidate.slug.length > 80) {
    issues.push("The slug must be a lowercase hyphenated URL name no longer than 80 characters.");
  }
  if (!candidate.primaryKeyword || candidate.primaryKeyword.length < 3 || candidate.primaryKeyword.length > 70) {
    issues.push("The primary keyword must contain 3 to 70 characters.");
  }
  if (secondaryKeywords.length < 2 || secondaryKeywords.length > 5 || secondaryKeywords.some((keyword) => typeof keyword !== "string")) {
    issues.push("Provide 2 to 5 secondary keywords.");
  }
  if (!candidate.category || candidate.category.length < 3 || candidate.category.length > 40) {
    issues.push("The category must contain 3 to 40 characters.");
  }
  if (internalLinks.length !== 4 || new Set(internalLinks).size !== 4) {
    issues.push("Choose exactly four unique internal links.");
  }
  if (!internalLinks.includes("/request-a-quote/")) {
    issues.push("The internal links must include /request-a-quote/.");
  }
  for (const url of internalLinks) {
    if (!knownLinks.has(url)) issues.push(`Unknown internal link: ${url}`);
  }
  if (!knownImages.has(candidate.image)) issues.push(`Choose one image from the supplied image list.`);
  if (!candidate.imageAlt || candidate.imageAlt.length < 20 || candidate.imageAlt.length > 140) {
    issues.push("The image description must contain 20 to 140 characters.");
  }
  if (sourceIds.length < 2 || sourceIds.length > 3 || new Set(sourceIds).size !== sourceIds.length) {
    issues.push("Choose two or three unique research source IDs.");
  }
  for (const id of sourceIds) {
    if (!knownSourceIds.has(id)) issues.push(`Unknown research source ID: ${id}`);
  }
  const selectedHosts = new Set(context.sourceCatalog
    .filter((source) => sourceIds.includes(source.id))
    .map((source) => new URL(source.url).hostname));
  if (sourceIds.length >= 2 && selectedHosts.size < 2) {
    issues.push("Choose research from at least two different websites.");
  }

  const normalizedKeyword = candidate.primaryKeyword?.toLowerCase();
  if (context.topics.some((topic) => topic.slug === candidate.slug)) issues.push("The slug was already used.");
  if (context.guides.some((guide) => guide.slug === candidate.slug)) issues.push("The slug already belongs to an existing guide.");
  if (context.topics.some((topic) => topic.primaryKeyword?.toLowerCase() === normalizedKeyword)) {
    issues.push("The primary keyword was already used.");
  }
  for (const guide of context.guides) {
    if (guide.data.primaryKeyword?.toLowerCase() === normalizedKeyword) issues.push("The primary keyword already belongs to an existing guide.");
    if (candidate.topic && guide.data.title && titleSimilarity(guide.data.title, candidate.topic) >= 0.7) {
      issues.push(`The topic is too similar to an existing guide: ${guide.data.title}`);
    }
  }
  return [...new Set(issues)];
}

function resolveTopicCandidate(candidate, sourceCatalog) {
  const sourcesById = new Map(sourceCatalog.map((source) => [source.id, source]));
  return {
    topic: candidate.topic,
    slug: candidate.slug,
    primaryKeyword: candidate.primaryKeyword,
    secondaryKeywords: candidate.secondaryKeywords,
    category: candidate.category,
    targetAudience,
    internalLinks: candidate.internalLinks,
    image: candidate.image,
    imageAlt: candidate.imageAlt,
    sources: candidate.sourceIds.map((id) => {
      const source = sourcesById.get(id);
      return { title: source.title, url: source.url };
    }),
    status: "queued",
    selectedBy: "AI",
    selectedAt: new Date().toISOString(),
  };
}

async function requestTopicCandidate(context, previousCandidate, issues) {
  const systemPrompt = `You are the editorial planner for ZiiBoxes, a custom paper packaging manufacturer.
Choose one useful, high-intent packaging question that is not already covered.
Write for small and medium-sized US brands, ecommerce sellers, product managers, and packaging buyers.
The topic must be supported by the supplied research catalog and help a buyer make a practical packaging decision.
Avoid news, prices, legal advice, unsupported sustainability claims, and topics that depend on facts outside the supplied sources.
Use only supplied source IDs, internal URLs, and image paths.
Return valid JSON only with these fields: topic, slug, primaryKeyword, secondaryKeywords, category, internalLinks, image, imageAlt, sourceIds.`;
  const request = {
    task: previousCandidate
      ? "Correct the proposed topic so every issue is fixed."
      : "Select the next article topic.",
    rules: [
      "Choose a clear buyer question or decision topic, not a broad industry overview.",
      "Do not duplicate or closely paraphrase an existing article.",
      "Use a lowercase hyphenated slug.",
      "Choose exactly four internal links, including /request-a-quote/.",
      "Choose two or three relevant source IDs from at least two different websites.",
      "Choose one supplied image that closely matches the topic.",
      "Use concise American English and return JSON only.",
    ],
    existingArticles: context.guides.map((guide) => ({
      title: guide.data.title,
      slug: guide.slug,
      category: guide.data.category,
      primaryKeyword: guide.data.primaryKeyword || null,
    })),
    pastTopics: context.topics.map((topic) => ({
      topic: topic.topic,
      slug: topic.slug,
      primaryKeyword: topic.primaryKeyword,
    })),
    researchCatalog: context.sourceCatalog.map(({ id, title, topics }) => ({ id, title, topics })),
    allowedInternalLinks: context.internalLinks,
    allowedImages: context.images,
    previousCandidate,
    validationIssues: issues,
  };
  return requestModelJson([
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(request) },
  ]);
}

async function planAutomaticTopic(topics, guides) {
  const context = {
    topics,
    guides,
    sourceCatalog: JSON.parse(await readFile(sourceCatalogPath, "utf8")),
    internalLinks: await availableInternalLinks(guides),
    images: await availableGuideImages(),
  };
  let candidate;
  let issues = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    candidate = await requestTopicCandidate(context, candidate, issues);
    issues = topicCandidateIssues(candidate, context);
    if (!issues.length) {
      const topic = resolveTopicCandidate(candidate, context.sourceCatalog);
      const sourceResults = await Promise.allSettled(topic.sources.map(fetchSource));
      const research = sourceResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const failed = sourceResults
        .map((result, index) => result.status === "rejected" ? topic.sources[index].url : null)
        .filter(Boolean);
      if (research.length >= 2) {
        topic.sources = topic.sources.filter((source) => research.some((item) => item.url === source.url));
        return { topic, research };
      }
      issues = [`Fewer than two selected research pages were readable. Do not reuse these URLs: ${failed.join(", ")}`];
    }
    if (attempt < 2) console.log(`Automatic topic needs correction (${attempt + 1}/2): ${issues.join("; ")}`);
  }
  throw new Error(`Automatic topic failed checks:\n- ${issues.join("\n- ")}`);
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
  const existingGuides = await readGuideDocuments();
  let topic = topics.find((item) => item.status === "queued");
  let research;
  if (!topic) {
    console.log("No approved topic is queued. Planning one automatically.");
    const planned = await planAutomaticTopic(topics, existingGuides);
    topic = planned.topic;
    research = planned.research;
    topics.push(topic);
    await writeFile(topicsPath, `${JSON.stringify(topics, null, 2)}\n`, "utf8");
    console.log(`Planned automatic topic: ${topic.topic}`);
  }
  if (!Array.isArray(topic.sources) || topic.sources.length < 2 || topic.sources.length > 5) {
    throw new Error("A queued topic must have 2–5 approved research sources.");
  }

  if (existingGuides.some((guide) => guide.slug === topic.slug)) {
    throw new Error(`Guide already exists: ${topic.slug}`);
  }
  await ensureInternalLinksExist(topic.internalLinks);
  await access(path.join(siteRoot, "public", topic.image));

  console.log(`Reading ${topic.sources.length} approved sources for: ${topic.topic}`);
  if (!research) {
    const sourceResults = await Promise.allSettled(topic.sources.map(fetchSource));
    research = sourceResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
    for (const result of sourceResults.filter((item) => item.status === "rejected")) {
      console.warn(result.reason.message);
    }
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
  const context = {
    topics: [],
    guides: [{ slug: "existing-guide", data: { title: "Existing Packaging Guide" } }],
    sourceCatalog: [
      { id: "source-one", title: "Source one", url: "https://one.example.com/article" },
      { id: "source-two", title: "Source two", url: "https://two.example.com/article" },
    ],
    internalLinks: [
      { url: "/guides/existing-guide/" },
      { url: "/products/custom-mailer-boxes/" },
      { url: "/custom-packaging-sample-process/" },
      { url: "/request-a-quote/" },
    ],
    images: ["/images/guides/example.jpg"],
  };
  const candidate = {
    topic: "How Should You Plan Packaging for Product Returns?",
    slug: "packaging-for-product-returns",
    primaryKeyword: "packaging for product returns",
    secondaryKeywords: ["return-ready packaging", "reusable ecommerce boxes"],
    category: "Ecommerce packaging guide",
    internalLinks: context.internalLinks.map((link) => link.url),
    image: context.images[0],
    imageAlt: "Reusable ecommerce mailer box prepared for a product return",
    sourceIds: context.sourceCatalog.map((source) => source.id),
  };
  const issues = topicCandidateIssues(candidate, context);
  if (issues.length) throw new Error(`Automatic topic self-test failed: ${issues.join("; ")}`);
  if (!topicCandidateIssues({ ...candidate, slug: "existing-guide" }, context).includes("The slug already belongs to an existing guide.")) {
    throw new Error("Automatic topic self-test failed to catch a duplicate slug");
  }
  const topic = resolveTopicCandidate(candidate, context.sourceCatalog);
  if (topic.sources.length !== 2 || topic.status !== "queued") {
    throw new Error("Automatic topic self-test failed to resolve the selected sources");
  }
  console.log("Guide generator self-test passed.");
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else await main();
}
