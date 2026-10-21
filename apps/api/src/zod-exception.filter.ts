import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { FastifyReply } from "fastify";
import { ZodError } from "zod";

/** Request-body validation failures are client errors, not 500s. */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(400).send({
      statusCode: 400,
      message: "Validation failed",
      issues: exception.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
}
