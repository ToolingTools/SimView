import { z } from "zod";

const pngDataSchema = z.string().min(1).max(20_000_000);

export const saveReviewImagesInputSchema = z.object({
  screenshot: pngDataSchema,
  annotations: z
    .array(
      z.object({
        id: z.string().uuid(),
        screenshot: pngDataSchema,
      }),
    )
    .max(100),
});

export const saveReviewImagesOutputSchema = z.object({
  directory: z.string(),
  screenshotPath: z.string(),
  annotations: z.array(
    z.object({
      id: z.string().uuid(),
      screenshotPath: z.string(),
    }),
  ),
});

export type SaveReviewImagesInput = z.infer<typeof saveReviewImagesInputSchema>;
export type SaveReviewImagesOutput = z.infer<typeof saveReviewImagesOutputSchema>;
