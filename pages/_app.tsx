import type { AppProps } from "next/app";
import Head from "next/head";
import "../web/style.css";
import "../web/platform.css";
import "leaflet/dist/leaflet.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/space-grotesk";
import "../web/signal.css";
export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>MediFast · Find your medicine, meet your pharmacy</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="Medicine clarity, nearby pharmacies and pharmacist-reviewed availability requests."
        />
        <link rel="icon" href="/favicon.svg" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
