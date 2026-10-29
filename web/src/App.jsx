/**
 * App.jsx — SAICS v5 Application Root
 * =====================================
 * Context providers + Shell layout with routing.
 */

import { LibraryProvider } from "./context/LibraryContext";
import { AppProvider } from "./context/AppContext";
import Shell from "./components/Shell";

export default function App() {
  return (
    <LibraryProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </LibraryProvider>
  );
}
