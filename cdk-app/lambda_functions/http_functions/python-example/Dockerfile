FROM public.ecr.aws/lambda/python:3.13

COPY lambda_function.py contract.schema.json ${LAMBDA_TASK_ROOT}/

CMD ["lambda_function.lambda_handler"]
