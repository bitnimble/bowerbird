import { createContext } from 'react';

export type SliderIsolationRectangle = { left: number; top: number; width: number; height: number };
export type IsolatedSlider = { id: string; rectangle: SliderIsolationRectangle };
export type SliderIsolation = {
  active: IsolatedSlider | null;
  begin: (id: string, rectangle: SliderIsolationRectangle) => void;
  end: (id: string) => void;
};

export const SliderIsolationContext = createContext<SliderIsolation | null>(null);
