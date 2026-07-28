import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guidesDir = path.join(siteRoot, "src", "content", "guides");

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, body: text };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w]*):\s*(.*)$/);
    if (!field) continue;
    const [, key, raw] = field;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw.replace(/^['"]|['"]$/g, "");
    }
  }
  return { data, body: match[2].trim() };
}

export async function readGuideDocuments() {
  const files = (await readdir(guidesDir)).filter((file) => file.endsWith(".md"));
  return Promise.all(files.map(async (file) => {
    const parsed = parseFrontmatter(await readFile(path.join(guidesDir, file), "utf8"));
    return { slug: file.slice(0, -3), ...parsed };
  }));
}

export function citedSourceUrls(body, sources) {
  return sources.map((source) => source.url).filter((url) => body.includes(url));
}

function words(text) {
  return text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length || 0;
}

function titleTokens(title) {
  const ignored = new Set(["a", "an", "and", "for", "from", "how", "of", "the", "to", "vs", "what", "why", "with"]);
  return new Set(title.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => !ignored.has(word)) || []);
}

function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  const common = [...a].filter((word) => b.has(word)).length;
  return common / Math.max(1, new Set([...a, ...b]).size);
}

export function validateGenerated(article, topic, existingGuides = []) {
  const issues = [];
  const body = article.articleMarkdown?.trim() || "";
  const approvedSources = new Set(topic.sources.map((source) => source.url));
  const usedSources = new Set(article.sourceUrls || []);
  const externalLinks = new Set(body.match(/https:\/\/[^\s)\]]+/g) || []);
  const h2Count = body.match(/^## (?!#)/gm)?.length || 0;
  const faqBody = body.split(/^## FAQ\s*$/m)[1]?.split(/^## /m)[0] || "";
  const faqCount = faqBody.match(/^### /gm)?.length || 0;
  const wordCount = words(body);

  if (article.slug !== topic.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug || "")) {
    issues.push("文章网址名称与批准的选题不一致");
  }
  if (article.primaryKeyword?.toLowerCase() !== topic.primaryKeyword.toLowerCase()) {
    issues.push("主关键词与批准的选题不一致");
  }
  if (article.category !== topic.category) issues.push("文章分类与批准的选题不一致");
  if (!article.title || article.title.length > 80) issues.push("文章标题缺失或超过 80 个字符");
  if (!article.seoTitle || article.seoTitle.length > 60) issues.push("搜索标题缺失或超过 60 个字符");
  if (!article.description || article.description.length < 150 || article.description.length > 160) {
    issues.push("文章简介必须是 150–160 个字符");
  }
  if (wordCount < 1400 || wordCount > 2800) issues.push(`正文字数为 ${wordCount}，应在 1400–2800 之间`);
  if (h2Count < 6 || h2Count > 10) issues.push(`正文有 ${h2Count} 个二级标题，应有 6–10 个`);
  if (faqCount !== 5) issues.push(`FAQ 有 ${faqCount} 个问题，应正好有 5 个`);
  if (!/^\|.+\|\r?\n\|(?:\s*:?-+:?\s*\|)+/m.test(body)) issues.push("正文缺少比较表");
  if (!/^## Common Mistakes to Avoid\s*$/m.test(body)) issues.push("正文缺少 Common Mistakes to Avoid 章节");
  if (/^# /m.test(body)) issues.push("正文不应重复添加一级标题");
  if (/^## Table of Contents\s*$/m.test(body)) issues.push("网站会自动生成目录，正文不应重复添加");
  if (/\[COMPANY INPUT REQUIRED\]|in today'?s fast-paced world|game[- ]changer|unlock the power/i.test(body)) {
    issues.push("正文仍有占位符或禁用的空泛表达");
  }

  for (const url of topic.internalLinks) {
    if (!body.includes(`](${url})`)) issues.push(`正文缺少内部链接 ${url}`);
  }
  for (const url of usedSources) {
    if (!approvedSources.has(url)) issues.push(`使用了未批准的资料 ${url}`);
    if (!externalLinks.has(url)) issues.push(`资料已列出但正文没有引用 ${url}`);
  }
  for (const url of externalLinks) {
    if (!approvedSources.has(url)) issues.push(`正文包含未批准的外部链接 ${url}`);
  }
  if (usedSources.size < 2 || [...usedSources].filter((url) => externalLinks.has(url)).length < 2) {
    issues.push("正文至少要引用两条批准的资料");
  }

  for (const guide of existingGuides) {
    if (guide.slug === article.slug) issues.push("文章网址名称已存在");
    if (guide.data.primaryKeyword?.toLowerCase() === article.primaryKeyword?.toLowerCase()) {
      issues.push("主关键词与现有文章重复");
    }
    if (guide.data.title && titleSimilarity(guide.data.title, article.title || "") >= 0.7) {
      issues.push(`标题与现有文章过于接近：${guide.data.title}`);
    }
  }
  return [...new Set(issues)];
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function validateBuiltLinks(guide) {
  const issues = [];
  const links = [...guide.body.matchAll(/\]\((\/[^)\s#?]+)(?:[?#][^)]*)?\)/g)].map((match) => match[1]);
  for (const url of links) {
    const target = url.startsWith("/images/")
      ? path.join(siteRoot, "public", url)
      : path.join(siteRoot, "dist", url, url.endsWith("/") ? "index.html" : "");
    if (!(await pathExists(target))) issues.push(`${guide.slug} 的内部链接不存在：${url}`);
  }
  if (guide.data.image && !(await pathExists(path.join(siteRoot, "public", guide.data.image)))) {
    issues.push(`${guide.slug} 的文章图片不存在：${guide.data.image}`);
  }
  return issues;
}

function selfTest() {
  const sources = [
    { url: "https://example.com/source-one" },
    { url: "https://example.com/source-two" },
  ];
  const topic = {
    slug: "screen-vs-print",
    primaryKeyword: "packaging color difference",
    category: "Artwork checklist",
    internalLinks: ["/guides/artwork/", "/request-a-quote/"],
    sources,
  };
  const filler = Array(22).fill("You can compare the approved sample, substrate, lighting, ink system, and artwork before you place an order.").join(" ");
  const body = `A screen and a printed package produce color differently. [Adobe explains the color limits](https://example.com/source-one), while an [industry source covers profiles](https://example.com/source-two). Read the [artwork guide](/guides/artwork/) before you [request a quote](/request-a-quote/).

## Why Packaging Color Difference Happens

${filler}

## Compare the Main Variables

| Variable | Screen | Printed package |
| --- | --- | --- |
| Light | Emits light | Reflects light |

## Build a Reliable Color Specification

${filler}

## Check a Physical Sample

${filler}

## Common Mistakes to Avoid

${filler}

## Make the Final Decision

${filler}

## FAQ

### Why does color change?

The viewing method changes.

### Is CMYK exact?

No process can reproduce every screen color.

### Does paper matter?

Yes, its color and surface affect the result.

### Should you approve a sample?

Approve one when brand color is important.

### What should you send?

Send editable artwork and a clear color reference.`;
  const article = {
    title: "Why Packaging Color Difference Happens",
    seoTitle: "Packaging Color Difference Explained",
    description: "D".repeat(155),
    category: topic.category,
    slug: topic.slug,
    primaryKeyword: topic.primaryKeyword,
    articleMarkdown: body,
    sourceUrls: sources.map((source) => source.url),
  };
  const cited = citedSourceUrls(body, [...sources, { url: "https://example.com/not-cited" }]);
  if (cited.length !== 2 || cited.includes("https://example.com/not-cited")) {
    throw new Error("Self-test failed to remove a source that was not cited");
  }
  const issues = validateGenerated(article, topic);
  if (issues.length) throw new Error(`Self-test failed: ${issues.join("; ")}`);
  if (!validateGenerated({ ...article, articleMarkdown: body.replace(/\| Variable[\s\S]*?\| Light.*\n/, "") }, topic)
    .includes("正文缺少比较表")) {
    throw new Error("Self-test failed to catch a missing comparison table");
  }
  console.log("Guide validation self-test passed.");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const topics = JSON.parse(await readFile(path.join(siteRoot, "data", "blog-topics.json"), "utf8"));
  const guides = await readGuideDocuments();
  const issues = [];
  const titles = new Set();
  const keywords = new Set();

  for (const guide of guides) {
    const titleKey = guide.data.title?.toLowerCase();
    if (titleKey && titles.has(titleKey)) issues.push(`文章标题重复：${guide.data.title}`);
    if (titleKey) titles.add(titleKey);
    if (guide.data.primaryKeyword) {
      const keyword = guide.data.primaryKeyword.toLowerCase();
      if (keywords.has(keyword)) issues.push(`主关键词重复：${guide.data.primaryKeyword}`);
      keywords.add(keyword);
      const topic = topics.find((item) => item.slug === guide.slug);
      if (!topic) {
        issues.push(`${guide.slug} 在选题文件中没有记录`);
      } else {
        issues.push(...validateGenerated({
          ...guide.data,
          slug: guide.slug,
          articleMarkdown: guide.body,
          sourceUrls: guide.data.sources || [],
        }, topic, guides.filter((item) => item.slug !== guide.slug)));
      }
    }
    issues.push(...await validateBuiltLinks(guide));
  }

  if (issues.length) {
    console.error(issues.map((issue) => `- ${issue}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Checked ${guides.length} guides: content, images, and internal links are valid.`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  await main();
}
