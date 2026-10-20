import { type ClassValue, clsx } from 'clsx';
import { produce, type WritableDraft } from 'immer';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const isInToday = (timestamp: number) => {
  const date = new Date(timestamp);
  const today = new Date();

  return date.toDateString() === today.toDateString();
};

export const isInThisWeek = (timestamp: number) => {
  const date = new Date(timestamp);
  const today = new Date();

  const monday = new Date(today);
  monday.setDate(today.getDate() - (today.getDay() || 7) + 1);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return date >= monday && date <= sunday;
};

export const withImmer = <T>(dispatch: (update: (data: T) => T) => void) => {
  return (recipe: (draft: WritableDraft<T>) => void) => {
    const update = produce(recipe) as (data: T) => T;

    dispatch(update);
  };
};
