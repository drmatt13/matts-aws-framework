import { ensureCognitoUser, type UserRecord } from "@repo/database";
import { z } from "zod";
import { builder } from "./builder";
import { badUserInput, invalidPayload, notFound } from "./errors";

const UpdateCurrentUserSchema = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  })
  .strict();

// Only the fields listed here reach the client. `cognitoSub` is deliberately
// absent -- it is an internal identity key, not public profile data.
const CurrentUser = builder.objectRef<UserRecord>("CurrentUser").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    email: t.exposeString("email"),
    firstName: t.exposeString("firstName"),
    lastName: t.exposeString("lastName"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

// Mutations return a payload object so fields can be added later (validation
// errors as data, affected-record lists) without a breaking schema change.
// Queries return the object directly -- a wrapper there buys nothing.
const UpdateCurrentUserPayload = builder
  .objectRef<{ user: UserRecord }>("UpdateCurrentUserPayload")
  .implement({
    fields: (t) => ({
      user: t.field({
        type: CurrentUser,
        resolve: (payload) => payload.user,
      }),
    }),
  });

const UpdateCurrentUserInput = builder.inputType("UpdateCurrentUserInput", {
  fields: (t) => ({
    firstName: t.string({ required: false }),
    lastName: t.string({ required: false }),
  }),
});

builder.queryField("currentUser", (t) =>
  t.field({
    type: CurrentUser,
    resolve: async (_parent, _args, context) => {
      let user = await context.database.users.findByCognitoSub(
        context.session.payload.sub,
      );

      if (!user) {
        const { email, email_verified, given_name, family_name } =
          context.session.payload;

        if (typeof email !== "string" || email_verified !== true) {
          throw notFound("User not found");
        }

        user = await ensureCognitoUser(context.database.users, {
          cognitoSub: context.session.payload.sub,
          email,
          firstName:
            typeof given_name === "string" && given_name.trim()
              ? given_name.trim()
              : email.split("@")[0],
          lastName:
            typeof family_name === "string" ? family_name.trim() : "",
        });
      }

      return user;
    },
  }),
);

builder.mutationField("updateCurrentUser", (t) =>
  t.field({
    type: UpdateCurrentUserPayload,
    args: {
      data: t.arg({ type: UpdateCurrentUserInput, required: true }),
    },
    resolve: async (_parent, args, context) => {
      const parsedData = UpdateCurrentUserSchema.safeParse(args.data);

      if (!parsedData.success) {
        throw invalidPayload("Invalid user update payload", parsedData.error);
      }

      if (Object.keys(parsedData.data).length === 0) {
        throw badUserInput("No user fields to update");
      }

      const user = await context.database.users.updateByCognitoSub(
        context.session.payload.sub,
        parsedData.data,
      );

      if (!user) {
        throw notFound("User not found");
      }

      return { user };
    },
  }),
);
