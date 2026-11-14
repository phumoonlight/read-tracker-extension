import { HOME_EMOJI, type Folder, type FolderColor, type HomeSettings } from '@/lib/types';

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
      <span className={`place-name${color ? ` place-c-${color}` : ''}`}>{name}</span>
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
