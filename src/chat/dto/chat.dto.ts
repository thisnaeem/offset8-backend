import { IsString, IsOptional, IsBoolean, IsEnum, IsArray, IsInt, IsDateString, MinLength, MaxLength } from 'class-validator';

export enum ChannelTypeDto { PUBLIC = 'PUBLIC', PRIVATE = 'PRIVATE' }

export class CreateChannelDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(ChannelTypeDto) type?: ChannelTypeDto;
  @IsOptional() @IsArray() @IsString({ each: true }) memberIds?: string[];
}

export class UpdateChannelDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() topic?: string;
  @IsOptional() @IsBoolean() isArchived?: boolean;
  @IsOptional() @IsInt() retentionDays?: number;
}

export class SendMessageDto {
  @IsString() @MinLength(1) content: string;
  @IsOptional() @IsString() contentJson?: string;
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsArray() attachments?: AttachmentDto[];
  @IsOptional() @IsBoolean() isScheduled?: boolean;
  @IsOptional() @IsDateString() scheduledAt?: string;
}

export class AttachmentDto {
  @IsString() fileName: string;
  @IsString() fileUrl: string;
  @IsString() fileType: string;
  @IsInt() fileSize: number;
  @IsOptional() @IsString() cloudinaryId?: string;
}

export class EditMessageDto {
  @IsString() @MinLength(1) content: string;
  @IsOptional() @IsString() contentJson?: string;
}

export class ToggleReactionDto {
  @IsString() emoji: string;
}

export class StartDmDto {
  @IsArray() @IsString({ each: true }) userIds: string[];
}

export class UpdateStatusDto {
  @IsOptional() @IsString() emoji?: string;
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsDateString() dndUntil?: string;
}

export class CreatePollDto {
  @IsString() question: string;
  @IsArray() @IsString({ each: true }) options: string[];
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsBoolean() anonymous?: boolean;
}

export class CreateReminderDto {
  @IsDateString() remindAt: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() messageId?: string;
}

export class CreateUserGroupDto {
  @IsString() name: string;
  @IsString() handle: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @IsString({ each: true }) memberIds: string[];
}

export class CreateWorkflowDto {
  @IsString() name: string;
  @IsString() trigger: string;
  @IsString() actions: string;
  @IsOptional() @IsString() channelId?: string;
}
