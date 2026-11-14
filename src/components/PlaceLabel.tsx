import type { CSSProperties } from 'react';
import { isCustomColor } from '@/lib/folders';
import { HOME_EMOJI, type Folder, type FolderColor, type HomeSettings } from '@/lib/types';

/**
 * Class and style that colour a place name: `.place-c-<key>` for a palette colour, or
 * `.place-c-custom` with `--place-c` set inline for a picked "#rrggbb".
 */
export function placeColor(color: FolderColor | undefined): { className?: string; style?: CSSProperties } {
  if (!color) return {};
  if (isCustomColor(color)) return { className: 'place-c-custom', style: { ['--place-c' as string]: color } };
  return { className: `place-c-${color}` };
}

/**
 * A place's name as shown in chips and pickers: its emoji (Home's is always 🏠), then the
 * name in its colour (`.place-c-<color>`, tokens in base.css). Two inline elements, so it
 * fits inside a flex chip whose `gap` spaces them.
 */
export function PlaceLabel({ name, emoji, color }: { name: string; emoji?: string; color?: FolderColor }) {
  return (
    <>
      {emoji && (
        <span className="place-emoji" aria-hidden="true">
          {emoji}
        </span>
      )}
      <span className={`place-name ${placeColor(color).className ?? ''}`} style={placeColor(color).style}>
        {name}
      </span>
    </>
  );
}

/** Home's label (fixed emoji, its own colour). */
export const HomeLabel = ({ home }: { home?: Pick<HomeSettings, 'color'> }) => (
  <PlaceLabel name="Home" emoji={HOME_EMOJI} color={home?.color} />
);

/** A folder's label. */
export const FolderLabel = ({ folder }: { folder: Pick<Folder, 'name' | 'emoji' | 'color'> }) => (
  <PlaceLabel name={folder.name} emoji={folder.emoji} color={folder.color} />
);
