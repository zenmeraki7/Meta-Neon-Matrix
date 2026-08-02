import { configureStore, combineReducers } from '@reduxjs/toolkit';

// Import reducers
import productReducer from './slices/productSlice';
import subscriptionReducer from './slices/subscriptionSlice';

// Combine reducers
const rootReducer = combineReducers({
  products: productReducer,
  subscription: subscriptionReducer,
});

// Create the store
export const store = configureStore({
  reducer: rootReducer,
});

// Infer types from the store itself
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Default export
export default store;
