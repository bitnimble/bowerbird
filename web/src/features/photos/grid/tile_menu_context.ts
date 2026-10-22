import { createContext, useContext } from 'react';
import type { TileSubject } from '../photos_store';

export type OpenTileMenu = (e: React.MouseEvent<HTMLElement>, tile: TileSubject) => void;

export const TileMenuContext = createContext<OpenTileMenu | null>(null);

/** Null outside a `TileMenu`, where a right click is the browser's. */
export const useTileMenu = (): OpenTileMenu | null => useContext(TileMenuContext);
