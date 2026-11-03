import dynamic from "next/dynamic";
const MediFast = dynamic(() => import("../web/main"), {
  ssr: false,
  loading: () => <div style={{ padding: 40 }}>Opening MediFast…</div>,
});
export default MediFast;
