import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

const guides = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/guides" }),
  schema: z.object({
    title: z.string(),
    seoTitle: z.string().optional(),
    description: z.string(),
    category: z.string(),
    order: z.number(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date(),
    primaryKeyword: z.string().optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    sources: z.array(z.string()).optional(),
  }),
});

export const collections = { guides };
