import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'The slug must contain only lowercase English letters, numbers, and dashes (e.g., skin-care)',
  })
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  image?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'The slug must contain only lowercase English letters, numbers, and dashes (e.g., skin-care)',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  image?: string;
}
