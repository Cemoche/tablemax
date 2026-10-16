import { strings } from "./lib/strings";

function App() {
  return (
    <main className="flex h-screen flex-col items-center justify-center">
      <h1 className="text-2xl font-semibold">{strings.appName}</h1>
      <p className="text-sm opacity-70">{strings.tagline}</p>
    </main>
  );
}

export default App;
