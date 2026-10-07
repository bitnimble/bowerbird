import { createContext } from 'react';

export type IsolationRectangle = { left: number; top: number; width: number; height: number };
export type Isolated = { id: string; rectangle: IsolationRectangle };
/** A control being dragged on its own, with the sheet it sits in hidden around it. */
export type Isolation = {
  active: Isolated | null;
  begin: (id: string, rectangle: IsolationRectangle) => void;
  end: (id: string) => void;
};

export const IsolationContext = createContext<Isolation | null>(null);
