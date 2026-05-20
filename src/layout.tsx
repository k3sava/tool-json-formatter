import type { Metadata } from "next";
import { JsonLd, softwareLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "JSON Formatter & Validator | Free, Ad-Free | Kami Studios",
  description:
    "Format, beautify, minify, and validate JSON with adjustable indentation and a collapsible tree view. No ads, no tracking.",
  authors: [{ name: "Kesava" }],
  alternates: { canonical: "https://tools.iamkesava.com/json-formatter" },
  openGraph: {
    title: "JSON Formatter & Validator | Free, Ad-Free | Kami Studios",
    description:
      "Format, beautify, minify, and validate JSON with adjustable indentation and a collapsible tree view. No ads, no tracking.",
    url: "https://tools.iamkesava.com/json-formatter",
    siteName: "Kami Studios",
    type: "website",
    images: [{ url: "https://tools.iamkesava.com/og/json-formatter.svg", width: 1200, height: 630 }]
  },
  twitter: {
    card: "summary_large_image",
    title: "JSON Formatter & Validator | Free, Ad-Free | Kami Studios",
    description:
      "Format, beautify, minify, and validate JSON with adjustable indentation and a collapsible tree view. No ads, no tracking.",
    images: ["https://tools.iamkesava.com/og/json-formatter.svg"]
  },
};

export default function JsonFormatterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <JsonLd data={softwareLd({"slug":"json-formatter","name":"JSON Formatter","description":"Format, beautify, minify, and validate JSON.","collection":"Developers","collectionHref":"/for/developers"})} />
      {children}
    </>
  );
}
