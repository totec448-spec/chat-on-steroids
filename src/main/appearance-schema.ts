import { z } from 'zod';
import { APPEARANCE_FONTS, SIDEBAR_LAYOUTS } from '../shared/appearance.js';

const color = z.string().regex(/^#[\da-fA-F]{6}$/);
const palette = z.object({ background: color, sidebar: color, accent: color, contrast: z.number().int().min(0).max(100) });
/** Shared by disk validation and Settings IPC. No authored CSS or remote font URLs. */
export const appearanceSchema = z.object({
  light: palette, dark: palette, font: z.enum(APPEARANCE_FONTS),
  fontSize: z.number().int().min(12).max(18), translucentSidebar: z.boolean(),
  // Also newer: a save without it, or off the slider's 10-percent steps, reads as normal spacing.
  lineSpacing: z.number().int().min(100).max(200).multipleOf(10).catch(100),
  // Newer than the rest: a save without it, or with a retired layout, opens on the project tree.
  sidebarLayout: z.enum(SIDEBAR_LAYOUTS).catch('projects'),
  // Newer still: a save without it, or with a damaged value, opens without high contrast.
  highContrast: z.boolean().optional().catch(false)
});
