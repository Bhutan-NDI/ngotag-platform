import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ResponseMessages } from '@credebl/common/response-messages';

const DEFAULT_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_MS = 60 * 1000;

const maxAgeMs = (): number => {
  const seconds = Number(process.env.STEP_UP_MAX_AGE_SECONDS);
  return 1000 * (Number.isInteger(seconds) && 0 < seconds ? seconds : DEFAULT_MAX_AGE_SECONDS);
};

/**
 * Requires a recent email-and-password sign-in, for actions that hand over an organisation's keys (SAD 7.2). The
 * session row is created at sign-in and a token refresh never changes its createdAt, so only signing in again
 * passes; a stolen access token that is older than the window does not. A service token has no sign-in at all.
 */
@Injectable()
export class StepUpAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();

    const isUserToken = user && !Object.prototype.hasOwnProperty.call(user, 'client_id');
    const signedInAt = user?.sessionCreatedAt ? new Date(user.sessionCreatedAt).getTime() : NaN;
    const age = Date.now() - signedInAt;

    if (!isUserToken || !user.sid || !Number.isFinite(signedInAt) || age > maxAgeMs() || age < -CLOCK_SKEW_MS) {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: ResponseMessages.agent.error.stepUpRequired,
          error: 'STEP_UP_REQUIRED'
        },
        HttpStatus.UNAUTHORIZED
      );
    }
    return true;
  }
}
