import { z } from "zod";
import { reviewOutputSchema } from "./analysis";

export const reviewOutputJsonSchema = z.toJSONSchema(reviewOutputSchema);
