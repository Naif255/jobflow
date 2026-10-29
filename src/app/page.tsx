import { PageHeader } from "@/components/ui";
import { AddJobForm } from "./add-job-form";

export default function Home() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="إضافة وظيفة"
        description="الصق رابط الوظيفة أو نص الإعلان كاملاً. سيتم استخراج البيانات وتقييم مدى ملاءمتها لملفك وحفظها."
      />
      <AddJobForm />
    </div>
  );
}
