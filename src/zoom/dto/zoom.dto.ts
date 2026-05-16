import { IsString, IsOptional, IsDateString, IsNumber, IsBoolean, IsArray, IsEmail } from 'class-validator';

export class CreateMeetingDto {
  @IsString() title: string;
  @IsOptional() @IsString() agenda?: string;
  @IsDateString() startTime: string;
  @IsNumber() duration: number;            // minutes
  @IsOptional() @IsArray() @IsEmail({}, { each: true }) participants?: string[];
  @IsOptional() @IsBoolean() isInstant?: boolean;
}

export class UpdateMeetingDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() agenda?: string;
  @IsOptional() @IsDateString() startTime?: string;
  @IsOptional() @IsNumber() duration?: number;
  @IsOptional() @IsArray() participants?: string[];
}

export class AskQuestionDto {
  @IsString() question: string;
}
