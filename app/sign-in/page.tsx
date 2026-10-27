import { SignInForm } from "@/components/auth-forms";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Sign in — Medrella" };

export default function SignInPage() {
  return (
    <div className="mx-auto max-w-md py-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <p className="text-sm text-slate-500">Sign in to manage your appointments.</p>
        </CardHeader>
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>

      <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-xs text-slate-600">
        <p className="font-medium text-slate-700">Demo accounts (after seeding)</p>
        <p className="mt-1">Patient: patient@demo.com · password123</p>
        <p>Doctor: doctor@demo.com · password123</p>
      </div>
    </div>
  );
}
