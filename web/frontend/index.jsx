import App from "./App";
import { createRoot } from "react-dom/client";
import { initI18n } from "./utils/i18nUtils";
import { Provider } from "react-redux";
import store from "./store";
import { reportWebVitals } from "./webVitals";

function bootstrap() {
  const rootElement = document.getElementById("app");
  const root = createRoot(rootElement);

  root.render(
    <Provider store={store}>
      <App />
    </Provider>,
  );

  void initI18n().catch((error) => {
    console.error("Failed to initialize app translations", error);
  });

  reportWebVitals((metric) => {
    if (import.meta.env.DEV) {
      console.info("[web-vitals]", metric.name, metric.value);
    }
  });
}

void bootstrap();
