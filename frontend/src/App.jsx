import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Shell from "./components/Shell";
import Library from "./pages/Library";
import InfiniteJukebox from "./pages/InfiniteJukebox";
import TrackTransitions from "./pages/TrackTransitions";
import { LibraryProvider } from "./context/LibraryContext";

export default function App() {
  return (
    <LibraryProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route index element={<Navigate to="/library" replace />} />
            <Route path="library"     element={<Library />} />
            <Route path="jukebox"     element={<InfiniteJukebox />} />
            <Route path="transitions" element={<TrackTransitions />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </LibraryProvider>
  );
}
