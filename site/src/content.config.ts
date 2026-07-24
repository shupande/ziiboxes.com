import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

const guides = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/guides" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    order: z.number(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date(),
  }),
});

export const collections = { guides };
