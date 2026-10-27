import { SystemRole, WhatsappAccessMode } from "entities/user.entity";
import { hasFullWhatsappAccountAccess } from "./whatsapp-account-access";

const ADMIN_ID = "07477638-7da7-42be-941b-e1b714404856";

test("grants access to admin role", () => {
  expect(
    hasFullWhatsappAccountAccess({
      id: ADMIN_ID,
      role: { name: SystemRole.ADMIN },
    }),
  ).toBe(true);
});

test("grants access to whatsappAccessMode all", () => {
  expect(
    hasFullWhatsappAccountAccess({
      id: "employee-1",
      adminId: ADMIN_ID,
      role: { name: SystemRole.USER },
      whatsappAccessMode: WhatsappAccessMode.ALL,
    }),
  ).toBe(true);
});

test("grants access to tenant system actors used by campaigns and workers", () => {
  expect(
    hasFullWhatsappAccountAccess({ id: ADMIN_ID, adminId: ADMIN_ID }),
  ).toBe(true);
});

test("denies access to employees with selected accounts", () => {
  expect(
    hasFullWhatsappAccountAccess({
      id: "employee-1",
      adminId: ADMIN_ID,
      role: { name: SystemRole.USER },
      whatsappAccessMode: WhatsappAccessMode.SELECTED,
    }),
  ).toBe(false);
});
