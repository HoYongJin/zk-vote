import { useDispatch, useSelector } from 'react-redux';
import type { TypedUseSelectorHook } from 'react-redux';
import type { AppDispatch, RootState } from './store';

/** Typed `useDispatch` — knows about the app's thunk-capable dispatch. */
export const useAppDispatch: () => AppDispatch = useDispatch;
/** Typed `useSelector` — infers state shape from RootState. */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
